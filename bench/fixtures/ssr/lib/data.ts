export interface Item {
  id: number
  name: string
  category: string
  price: number
}

const CATEGORIES = ['Tooling', 'Runtime', 'Compiler', 'Router', 'Renderer']

export const items: Item[] = Array.from({ length: 50 }, (_, index) => ({
  id: index + 1,
  name: `Package ${String(index + 1).padStart(2, '0')}`,
  category: CATEGORIES[index % CATEGORIES.length],
  price: 20 + ((index * 7) % 80),
}))

export interface Post {
  slug: string
  title: string
  body: string
}

export const posts: Post[] = Array.from({ length: 12 }, (_, index) => ({
  slug: `post-${index + 1}`,
  title: `Rendering note ${index + 1}`,
  body: `Server-rendered body for post ${index + 1}. Streamed from the server with no client JavaScript.`,
}))

export function findPost(slug: string) {
  return posts.find(post => post.slug === slug)
}
