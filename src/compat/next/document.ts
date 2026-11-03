import { h, type ComponentChildren } from 'preact'

type Props = { children?: ComponentChildren } & Record<string, unknown>

export const Html = (props: Props) => h('html', props)
export const Head = (props: Props) => h('head', props)
export const Main = () => null
export const NextScript = () => null

export default function Document() {
  return h(Html, null, h(Head, null), h('body', null, h(Main, null), h(NextScript, null)))
}
