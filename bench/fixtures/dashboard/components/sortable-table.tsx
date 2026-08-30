'use client'

import { useState } from 'react'
import Badge from './badge'
import { count, currency } from '../lib/format'
import type { Column } from '../lib/types'

/** Client island: the header cells re-sort the already-rendered page slice. */
export default function SortableTable<T extends { id: string }>({
  rows,
  columns,
  hrefBase,
}: {
  rows: T[]
  columns: Column<T>[]
  hrefBase?: string
}) {
  const [sort, setSort] = useState<{ key: keyof T & string; desc: boolean } | null>(null)
  const sorted = sort
    ? [...rows].sort((a, b) => {
        const left = a[sort.key]
        const right = b[sort.key]
        const compared =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right))
        return sort.desc ? -compared : compared
      })
    : rows

  return (
    <table className="table">
      <thead>
        <tr>
          {columns.map(column => (
            <th key={column.key} className={column.align === 'right' ? 'right' : undefined}>
              <button
                type="button"
                className="th-sort"
                onClick={() =>
                  setSort(current => ({
                    key: column.key,
                    desc: current?.key === column.key ? !current.desc : false,
                  }))
                }
              >
                {column.header}
                {sort?.key === column.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => (
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
                ) : index === 0 && hrefBase ? (
                  <a href={`${hrefBase}/${row.id}`}>{String(value)}</a>
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
