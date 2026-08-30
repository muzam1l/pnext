import type { ReactNode } from 'react'

export default function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'bad'
  title: string
  children?: ReactNode
}) {
  return (
    <aside className={`callout callout-${tone}`}>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </aside>
  )
}
