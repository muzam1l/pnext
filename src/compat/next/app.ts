import { h, type ComponentType } from 'preact'

export default function App({
  Component,
  pageProps,
}: {
  Component: ComponentType<Record<string, unknown>>
  pageProps: Record<string, unknown>
}) {
  return h(Component, pageProps)
}
