import styles from './timeline.module.css'
import type { AuditEntry } from '../lib/types'

export default function Timeline({ entries }: { entries: AuditEntry[] }) {
  return (
    <ol className={styles.timeline}>
      {entries.map(entry => (
        <li key={entry.id} className={`${styles.entry} ${styles[entry.severity] ?? ''}`}>
          <span className={styles.action}>
            {entry.actor} {entry.action}
          </span>
          <span className={styles.meta}>
            {entry.target} · {entry.at} · {entry.severity}
          </span>
        </li>
      ))}
    </ol>
  )
}
