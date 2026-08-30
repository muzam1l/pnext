import { findPost, posts } from '../../../lib/data'

export function generateStaticParams() {
  return posts.map(post => ({ slug: post.slug }))
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = findPost(slug)
  return (
    <main>
      <h1>{post?.title ?? 'Unknown post'}</h1>
      <p>{post?.body ?? `No post matches ${slug}.`}</p>
    </main>
  )
}
