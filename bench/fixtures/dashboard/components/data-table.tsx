import Badge from './badge'
import { count, currency } from '../lib/format'
import type { Column } from '../lib/types'

export default function DataTable<T extends { id: string }>({
  rows,
  columns,
  href,
}: {
  rows: T[]
  columns: Column<T>[]
  href?: (row: T) => string
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map(column => (
            <th key={column.key} className={column.align === 'right' ? 'right' : undefined}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            {columns.map((column, index) => {
              const value = row[column.key]
              const cell =
                column.format === 'currency' ? (
                  currency(Number(value))
                ) : column.format === 'number' ? (
                  count(Number(value))
                ) : column.format === 'status' ? (
                  <Badge status={String(value)} />
                ) : index === 0 && href ? (
                  <a href={href(row)}>{String(value)}</a>
                ) : (
                  String(value)
                )
              return (
                <td key={column.key} className={column.align === 'right' ? 'right' : undefined}>
                  {cell}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
