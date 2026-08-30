import { h, type ComponentType } from 'preact'
import { Suspense } from '@wular/pnext'

export const metadata = {
  lang: 'en',
  title: 'PNext fixture',
  description: 'Fixture for PNext tests.',
  icons: [{ rel: 'icon', url: '/favicon.ico', sizes: 'any' }],
  links: [{ rel: 'preload', url: '/logo.svg', as: 'image', fetchPriority: 'high' }],
}

async function message() {
  return Promise.resolve('Async server component')
}

async function SlowMessage() {
  await Promise.resolve()
  return <strong>Streamed server content</strong>
}

export default async function Home() {
  return (
    <>
      <h1>Hello from PNext</h1>
      <p>{await message()}</p>
      <Suspense fallback={<p>Loading server content</p>}>
        {h(SlowMessage as ComponentType, {})}
      </Suspense>
    </>
  )
}
