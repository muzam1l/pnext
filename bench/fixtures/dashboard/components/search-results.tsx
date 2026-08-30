import EmptyState from './empty-state'
import Tag from './tag'
import type { SearchHit } from '../lib/types'

export default function SearchResults({ hits }: { hits: SearchHit[] }) {
  if (!hits.length) return <EmptyState message="Nothing matched that query." />
  return (
    <ul className="hits">
      {hits.map(hit => (
        <li key={`${hit.kind}-${hit.id}`}>
          <a href={hit.href}>{hit.title}</a>
          <span className="muted"> {hit.subtitle}</span> <Tag label={hit.kind} />
        </li>
      ))}
    </ul>
  )
}
