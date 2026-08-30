import type { PageProps } from '@wular/pnext'

export function generateStaticParams() {
  return [{ id: 'ada' }, { id: 'grace' }]
}

export default async function StaticUserPage({ params }: PageProps) {
  return <p>Static user {(await params).id}</p>
}
