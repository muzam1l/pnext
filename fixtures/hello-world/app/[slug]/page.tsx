import type { PageProps } from '@wular/pnext'

export default async function SlugPage({ params }: PageProps) {
  return <p>Slug {(await params).slug}</p>
}
