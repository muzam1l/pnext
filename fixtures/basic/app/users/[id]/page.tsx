import type { PageProps } from '@wular/pnext'

export default async function UserPage({ params }: PageProps) {
  return <p>User {(await params).id}</p>
}
