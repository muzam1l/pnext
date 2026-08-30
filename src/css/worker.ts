// CSS worker entry — runs the postcss/Tailwind pipeline off the event loop.
// One message per built stylesheet; the processor cache in ./postcss.ts lives
// here for the worker's lifetime, so Tailwind stays incremental across rebuilds.
import { loadPostcss, runPostcss } from './postcss'
export type CssWorkerRequest = { id: number; root: string; dev: boolean; outDir?: string } & (
  { kind: 'warm' } | { kind: 'process'; cssFile: string; from?: string }
)

export interface CssWorkerResponse {
  id: number
  error?: { name: string; message: string; stack?: string }
}

declare const self: Worker

self.onmessage = async (event: MessageEvent<CssWorkerRequest>) => {
  const request = event.data
  const reply = (response: CssWorkerResponse) => postMessage(response)
  try {
    const options = { dev: request.dev, outDir: request.outDir }
    if (request.kind === 'warm') await loadPostcss(request.root, options)
    else await runPostcss(request.root, request.cssFile, options, request.from)
    reply({ id: request.id })
  } catch (error) {
    reply({
      id: request.id,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'Error', message: String(error) },
    })
  }
}
