'use client'

import { useState } from 'react'

export default function FilterBar({
  facets,
  label,
}: {
  facets: { name: string; options: string[] }[]
  label: string
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Record<string, string>>({})
  const summary = [
    query ? `“${query}”` : '',
    ...Object.entries(selected)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}: ${value}`),
  ].filter(Boolean)

  return (
    <div className="filters">
      <label className="filter">
        Search
        <input
          className="input"
          placeholder={`Filter ${label}`}
          value={query}
          onInput={event => setQuery((event.target as HTMLInputElement).value)}
        />
      </label>
      {facets.map(facet => (
        <label key={facet.name} className="filter">
          {facet.name}
          <select
            className="input"
            value={selected[facet.name] ?? ''}
            onInput={event =>
              setSelected({ ...selected, [facet.name]: (event.target as HTMLSelectElement).value })
            }
          >
            <option value="">Any</option>
            {facet.options.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ))}
      <span className="toolbar-hint">{summary.length ? summary.join(' · ') : `All ${label}`}</span>
      {summary.length ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setQuery('')
            setSelected({})
          }}
        >
          Clear
        </button>
      ) : null}
    </div>
  )
}
