/**
 * `react-dom/server` compat surface (also aliased for `react-dom/server.edge`
 * and `react-dom/server.browser`). Next fixtures import react-dom/server inside
 * client components for the synchronous string renderers (renderToStaticMarkup,
 * renderToString). preact-render-to-string provides those; the streaming
 * server APIs (renderToReadableStream / renderToPipeableStream) have no direct
 * preact equivalent that fits a browser bundle, so they throw if invoked.
 */
import ReactCompat from 'preact/compat'
import {
  renderToStaticMarkup as preactRenderToStaticMarkup,
  renderToString as preactRenderToString,
  renderToStringAsync as preactRenderToStringAsync,
} from 'preact-render-to-string'

export const version = ReactCompat.version
export const renderToString = preactRenderToString
export const renderToStaticMarkup = preactRenderToStaticMarkup
export const renderToStringAsync = preactRenderToStringAsync

function unsupportedStream(name: string): never {
  throw new Error(`react-dom/server ${name} is not supported under pnext's preact runtime`)
}

export function renderToReadableStream(): never {
  return unsupportedStream('renderToReadableStream')
}

export function renderToPipeableStream(): never {
  return unsupportedStream('renderToPipeableStream')
}

export default {
  version,
  renderToString,
  renderToStaticMarkup,
  renderToStringAsync,
  renderToReadableStream,
  renderToPipeableStream,
}
