'use client'

import { useState } from 'react'
import styles from './command-palette.module.css'
import { primaryNav, settingsNav, supportNav, workspaceNav } from '../lib/nav'

const DESTINATIONS = [...primaryNav, ...workspaceNav, ...settingsNav, ...supportNav]

/** Jump-to-page stub. Record search lives on /search, which owns the index. */
export default function CommandPalette() {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? DESTINATIONS.filter(item => item.label.toLowerCase().includes(needle)).slice(0, 6)
    : []

  return (
    <div className={styles.palette}>
      <input
        className={`input ${styles.field}`}
        placeholder="Jump to…"
        value={query}
        onInput={event => setQuery((event.target as HTMLInputElement).value)}
      />
      {needle ? (
        <ul className={styles.results}>
          {matches.map(item => (
            <li key={item.href}>
              <a className={styles.hit} href={item.href}>
                {item.label}
                <span className={styles.kind}> {item.href}</span>
              </a>
            </li>
          ))}
          <li>
            <a className={styles.hit} href={`/search?q=${encodeURIComponent(query)}`}>
              Search records
            </a>
          </li>
        </ul>
      ) : null}
    </div>
  )
}
