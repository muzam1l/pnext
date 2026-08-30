import styles from './invoice-lines.module.css'
import { currency } from '../lib/format'
import type { InvoiceLine } from '../lib/types'

export default function InvoiceLines({ lines }: { lines: InvoiceLine[] }) {
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
  return (
    <table className={styles.lines}>
      <thead>
        <tr>
          <th>Description</th>
          <th className={styles.right}>Qty</th>
          <th className={styles.right}>Unit</th>
          <th className={styles.right}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, index) => (
          <tr key={index}>
            <td>{line.description}</td>
            <td className={styles.right}>{line.quantity}</td>
            <td className={styles.right}>{currency(line.unitPrice)}</td>
            <td className={styles.right}>{currency(line.quantity * line.unitPrice)}</td>
          </tr>
        ))}
        <tr className={styles.total}>
          <td colSpan={3}>Total</td>
          <td className={styles.right}>{currency(total)}</td>
        </tr>
      </tbody>
    </table>
  )
}
