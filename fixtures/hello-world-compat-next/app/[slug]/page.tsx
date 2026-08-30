export default async function SlugPage({ params }: { params: Promise<{ slug: string }> }) {
  return <p>Slug {(await params).slug}</p>
}
